import { normalizeWishlistLink } from '../utils/wishlist';
import '../styles/Wishlist.scss';

export default function WishlistDetails({ plant }) {
  const links = (Array.isArray(plant.links) ? plant.links : []).map(normalizeWishlistLink).filter(Boolean);
  if (!plant.description && !plant.price && !links.length) return null;
  return (
    <div className='wishlistDetails'>
      {plant.description && <p className='wishlistDescription'>{plant.description}</p>}
      {plant.price && <p className='wishlistPrice'><strong>Примерная цена: </strong>{plant.price}</p>}
      {links.length > 0 && <div className='wishlistLinks'>
        <strong>Ссылки</strong>
        <ul>{links.map((link, index) => <li key={link}><a href={link} target='_blank' rel='noopener noreferrer'>{new URL(link).hostname}{links.length > 1 ? ` · ${index + 1}` : ''}</a></li>)}</ul>
      </div>}
    </div>
  );
}
