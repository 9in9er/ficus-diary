import usePlantPhoto from '../hooks/usePlantPhoto';

export default function PlantPhoto({ plant, className, alt = plant.name }) {
  const { src, failed, retry, onError } = usePlantPhoto(plant);
  return <>
    {src && <img className={className} src={src} alt={alt} onError={plant.photoKey ? onError : undefined} />}
    {failed && <span className='formError' role='status'>Не удалось загрузить фото. <button type='button' className='btn' onClick={retry}>Повторить</button></span>}
  </>;
}
